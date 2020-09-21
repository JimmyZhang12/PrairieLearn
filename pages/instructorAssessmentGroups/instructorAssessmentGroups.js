const ERR = require('async-stacktrace');
const express = require('express');
const router = express.Router();
const path = require('path');
const debug = require('debug')('prairielearn:' + path.basename(__filename, '.js'));

const sanitizeName = require('../../lib/sanitize-name');
const error = require('@prairielearn/prairielib/error');
const groupUpdate = require('../../lib/group-update');
const sqldb = require('@prairielearn/prairielib/sql-db');
const sqlLoader = require('@prairielearn/prairielib/sql-loader');

const sql = sqlLoader.loadSqlEquiv(__filename);

/*
This function run all needed SQL queries to load the page at the same time that res passed in will be saved.
e.g res.locals.errormsg from POST functions can be displayed on the frontend.
*/
function obtainInfo(req, res, next){
    //downloads
    const prefix = sanitizeName.assessmentFilenamePrefix(res.locals.assessment, res.locals.assessment_set, res.locals.course_instance, res.locals.course);
    res.locals.groupsCsvFilename = prefix + 'groups.csv';
    
    //config and group info
    const params = {assessment_id: res.locals.assessment.id};
    sqldb.query(sql.config_info, params, function(err, result) {
        if (ERR(err, next)) return;
        res.locals.isGroup = true;
        if (result.rowCount == 0) {
            res.locals.isGroup = false;
            res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
            return;
        }
        res.locals.config_info = result.rows[0];
        res.locals.config_info.defaultMin = res.locals.config_info.minimum || 2;
        res.locals.config_info.defaultMax = res.locals.config_info.maximum || 5;

        const params = {
            assessment_id: res.locals.assessment.id,
            course_instance_id: res.locals.config_info.course_instance_id,
            group_config_id: res.locals.config_info.id,
        };
        sqldb.query(sql.assessment_list, params, function(err, result) {
            if (ERR(err, next)) return;
            res.locals.assessment_list_rows = result.rows;
            sqldb.query(sql.select_group_users, params, function(err, result) {
                if (ERR(err, next)) return;
                res.locals.groups = result.rows;
                sqldb.query(sql.select_not_in_group, params, function(err, result) {
                    if (ERR(err, next)) return;
                    res.locals.notAssigned = result.rows;
                    debug('render page');
                    res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
                });
            });
        });
    });
}
router.get('/', function(req, res, next) {
    debug('GET /');
    obtainInfo(req, res, next);
});

router.post('/', function(req, res, next) {
    if (!res.locals.authz_data.has_instructor_edit) return next();
    if (req.body.__action == 'upload_assessment_groups') {
        groupUpdate.uploadInstanceGroups(res.locals.assessment.id, req.file, res.locals.user.user_id, res.locals.authn_user.user_id, function(err, job_sequence_id) {
            if (ERR(err, next)) return;
            res.redirect(res.locals.urlPrefix + '/jobSequence/' + job_sequence_id);
        });
    } else if (req.body.__action == 'auto_assessment_groups') {
        groupUpdate.autoGroups(res.locals.assessment.id, res.locals.user.user_id, res.locals.authn_user.user_id, req.body.max_group_size, req.body.min_group_size, req.body.optradio, function(err, job_sequence_id) {
            if (ERR(err, next)) return;
            res.redirect(res.locals.urlPrefix + '/jobSequence/' + job_sequence_id);
        });
    } else if (req.body.__action == 'copy_assessment_groups') {
        //make sure the copying assessment_ belong to the same course_instance
        let sameInstance = false;
        res.locals.assessments.forEach(element => {
            if (element.id == req.body.copyAssessmentId) {
                sameInstance = true;
            }
        });
        if (!sameInstance) {
            res.locals.errormsg = 'The assessment that you are copying does not belong to the same course instance. Please select another one.';
            obtainInfo(req, res, next);
            return;
        }
        const params = [
            res.locals.assessment.id,
            req.body.copyAssessmentId,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('assessment_groups_copy', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else if (req.body.__action == 'delete_all') {
        const params = [
            res.locals.assessment.id,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('assessment_groups_delete_all', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else if (req.body.__action == 'add_group') {
        const assessment_id = res.locals.assessment.id;
        const groupname = req.body.groupname;
        if (String(groupname).length < 1) {
            res.locals.errormsg = 'Please enter a group name when adding a group';
            obtainInfo(req, res, next);
            return;
        }
        const uids = req.body.uids;
        const uidlist = uids.split(/[ ,]+/);
        res.locals.errormsg = '';
        let updateList = new Array();
        uidlist.forEach(uid => {
            updateList.push([groupname, uid]);
        });
        const params2 = [
            assessment_id,
            updateList,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('assessment_groups_update', params2, (err, result) => {
            if (err) {
                res.locals.errormsg = 'ERROR when adding group ' + groupname + ' - Internal ' + String(err);
            } else {
                const notExist = result.rows[0].not_exist_user;
                if (notExist) {
                    res.locals.errormsg += 'ERROR when adding group ' + groupname + ' - [' + notExist.toString() + ']. Please check if the group name is unique and whether their uids are correct.';
                }
                const inGroup = result.rows[0].already_in_group;
                if (inGroup) {
                    res.locals.errormsg += 'ERROR when adding group ' + groupname + ' - [' + inGroup.toString() + '] are already in another group.';
                }
            }
            obtainInfo(req, res, next);
        });
    } else if (req.body.__action == 'config_group') {
        res.locals.errormsg = '';
        const params = {
            assessment_id: res.locals.assessment.id,
            minsize: req.body.minsize,
            maxsize: req.body.maxsize,
            joincheck: req.body.joincheck || false,
            createcheck: req.body.createcheck || false,
            leavecheck: req.body.leavecheck || false,
        };
        if (req.body.maxsize.length < 1 || req.body.minsize.length < 1) {
            res.locals.errormsg += 'Please enter group max size and min size';
            obtainInfo(req, res, next);
            return;
        }
        sqldb.query(sql.config_group, params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else if (req.body.__action == 'add_member') {
        const assessment_id = res.locals.assessment.id;
        const gid = req.body.gid;
        const uids = req.body.addmemberuids;
        const uidlist = uids.split(/[ ,]+/);
        let failedUids = '';
        res.locals.errormsg = '';
        (async () => {
            for (const uid of uidlist) {
                const params = [
                    assessment_id,
                    gid,
                    uid,
                    res.locals.authn_user.user_id,
                ];
                try {
                    await sqldb.callAsync('assessment_groups_add_member', params);
                } catch (err) {
                    failedUids += '[' + uid + '] ';
                }
            }
            if (failedUids.length > 0) {
                res.locals.errormsg += 'Failed to add ' + failedUids + 'to Group No.' + gid + '. Please check if the uid exist.\n';
            }
            obtainInfo(req, res, next);
        })();
    } else if (req.body.__action == 'delete_member') {
        const assessment_id = res.locals.assessment.id;
        const gid = req.body.gid;
        const uids = req.body.deletememberuids;
        const uidlist = uids.split(/[ ,]+/);
        let failedUids = '';
        res.locals.errormsg = '';
        (async () => {
            for (const uid of uidlist) {
                const params = [
                    assessment_id,
                    gid,
                    uid,
                    res.locals.authn_user.user_id,
                ];
                try {
                    await sqldb.callAsync('assessment_groups_delete_member', params);
                } catch (err) {
                    failedUids += '[' + uid + '] ';
                }
            }
            if (failedUids.length > 0) {
                res.locals.errormsg += 'Failed to delete ' + failedUids + 'from Group No.' + gid + ']. Please check if the uid exist.\n';
            }
            obtainInfo(req, res, next);
        })();
    } else if (req.body.__action == 'delete_group') {
        const params = [
            res.locals.assessment.id,
            req.body.gid,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('assessment_groups_delete_group', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else {
        return next(error.make(400, 'unknown __action', {locals: res.locals, body: req.body}));
    }
});

module.exports = router;    
